/**
 * Apps workspace view — the content of an `app` tab: the app's home.
 *
 * Files are browsed/opened from the Apps explorer (each file gets its own
 * `app-file` tab, v1-style); this view owns everything app-level:
 *
 *   ┌ toolbar: dev session · Publish · History · Discard
 *   ├ preview: token-gated sandboxed iframe of the built app
 *   └ terminal: shell into the app's sandbox session (E2B microVM)
 *
 * Branch status, commit, and merge live in the Apps explorer's "Version
 * control" section (sidebar), not here — same split as Transforms.
 *
 * Every read resolves from git through the durable worktree API, so the view
 * renders identically whether the sandbox is hot, paused, or dead.
 */
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Tooltip,
  Typography,
  styled,
} from "@mui/material";
import {
  ExternalLink as ExternalLinkIcon,
  History as HistoryIcon,
  Play as PlayIcon,
  RefreshCw as RefreshIcon,
  Share2 as ShareIcon,
  Square as StopIcon,
  TerminalSquare as TerminalIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import { useRealtimeStore } from "../store/realtimeStore";
import {
  appUrlRef,
  devServerKeyMatches,
  useAppsStore,
} from "../store/appsStore";
import AppHistoryPopover from "./AppHistoryPopover";
import AppPublishedChip from "./AppPublishedChip";
import EntityLoadErrorState from "./EntityLoadErrorState";
import { useConsoleStore } from "../store/consoleStore";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";
import { separatorDragRef } from "../lib/iframe-drag-guard";
import { useIsMobile } from "../hooks/useIsMobile";
import { useUIStore } from "../store/uiStore";
import { useIsWorkspaceAdmin } from "../hooks/useIsWorkspaceAdmin";
import { useAppUsageBeacon } from "../hooks/useAppUsageBeacon";
import ShareDialog from "./ShareDialog";
import { appViewerPath } from "../store/shareStore";
import {
  APP_OPEN_FALLBACK_MS,
  appTabReadsReady,
  isAwaitingPublishedPaint,
  settleAppOpen,
} from "../lib/app-open-gate";
import { appFrameSandbox } from "../lib/app-frame";
import { forgetAppFrame, setAppFrameVisible } from "../lib/app-memory";
import { TerminalTabs } from "./app-workspace/TerminalTabs";
import { useHiddenPause } from "./app-workspace/terminal-utils";
import {
  AppOpeningState,
  DevPreviewPane,
} from "./app-workspace/WorkbenchStates";
import { usePublishedFrameBridge } from "./app-workspace/usePublishedFrameBridge";

const TerminalResizeHandle = styled(Separator)(({ theme }) => ({
  flex: "0 0 4px",
  height: "4px",
  alignSelf: "stretch",
  background: theme.palette.divider,
  touchAction: "none",
  transition: "background-color 0.2s ease",
  // The library reports hover/drag through this attribute; its hit area is
  // larger than the visible strip, so the highlight has to key off it rather
  // than off CSS :hover.
  "&[data-separator='hover'], &[data-separator='active']": {
    backgroundColor: theme.palette.primary.main,
  },
}));

// Makes iframes ignore the pointer while a divider is dragged (a cross-
// origin preview would otherwise swallow the drag). Stable: see separatorDragRef.
const guardSeparatorDrag = separatorDragRef();

export default function AppWorkspace({
  tabId: _tabId,
  appId,
}: {
  tabId: string;
  appId: string;
}) {
  const { currentWorkspace } = useWorkspace();
  const { user } = useAuth();
  const workspaceId = currentWorkspace?.id;
  const isWorkspaceAdmin = useIsWorkspaceAdmin();

  const app = useAppsStore(s => s.apps.find(a => a.id === appId));
  const status = useAppsStore(s => s.statusByApp[appId]);
  const branches = useAppsStore(s => s.branchesByApp[appId]);
  const preview = useAppsStore(s => s.previewByApp[appId]);
  const publishedSha = app?.publishedSha;
  const publishApp = useAppsStore(s => s.publishApp);

  // The terminal split is a panel Group, like every other pane in the app.
  //
  // It used to be a hand-rolled mousemove drag, which froze the moment the
  // cursor crossed the preview iframe: a cross-origin frame swallows
  // pointermove, so the parent window stops hearing about the drag. Drag
  // slowly and you stay on the handle and it works; drag fast and it hangs.
  // The iframe drag guard is the fix the rest of the app already uses — it
  // makes every iframe transparent to pointer events for the duration — and
  // using the same library also means this handle is the same size as the
  // others rather than a hand-picked 5px.
  const editing = useAppsStore(s => s.editingByApp[appId] ?? false);
  const setEditing = useAppsStore(s => s.setEditing);
  const slug = useAppsStore(
    s => s.apps.find(a => a.id === appId)?.slug ?? null,
  );
  // THE source of truth for "is a dev server running for this app" — the box,
  // via the pushed runningDevApps (same signal as the sidebar's green dot).
  // Every "running" affordance derives from this, so they cannot disagree
  // (apps.md §13.11).
  const runningDevApps = useAppsStore(s => s.runningDevApps);
  const devRunning = runningDevApps.some(k =>
    devServerKeyMatches(k, { id: appId, slug: slug ?? undefined }),
  );
  const viewUrl = useAppsStore(s => s.viewUrlByApp[appId]);
  const viewUrlError = useAppsStore(s => s.viewUrlErrorByApp[appId]);
  // The view URL the published iframe last finished loading. A new token
  // (a publish moved the app on) shows the opening card again until it loads.
  const [pubLoadedUrl, setPubLoadedUrl] = useState<string | null>(null);
  const pubLoaded = !!viewUrl && pubLoadedUrl === viewUrl;
  // Usage: only the PUBLISHED view counts, and only while this tab is the
  // one in front — background tabs stay mounted (display: none), and the
  // dev-mode preview is the author building, not someone using the app.
  const isFrontTab = useConsoleStore(s => s.activeTabId === _tabId);
  // The page-wide DuckDB budget asks background app frames to release, least
  // recently shown first, never the one in front.
  useEffect(() => {
    setAppFrameVisible(_tabId, isFrontTab);
  }, [_tabId, isFrontTab]);
  useEffect(() => () => forgetAppFrame(_tabId), [_tabId]);
  useAppUsageBeacon({
    workspaceId,
    appId,
    active: !editing && pubLoaded && isFrontTab,
    referrerKind: "internal",
  });
  const appsLoading = useAppsStore(s => s.appsLoading);
  const hiddenPaused = useHiddenPause();
  // Durable URL for the published app in a normal tab: its viewer page, the
  // canonical address people copy (the raw /api/…/live/ route only redirects
  // there). The token URL (viewUrl) exists ONLY for the sandboxed iframe,
  // whose opaque origin cannot send cookies; tokens are short-lived and
  // in-memory, so handing them to window.open produced "Preview expired"
  // minutes later.
  const liveUrl =
    app?.publishedSha && workspaceId
      ? appViewerPath(workspaceId, appId)
      : undefined;
  const fetchViewUrl = useAppsStore(s => s.fetchViewUrl);
  // Phone: the workbench is one pane at a time (preview OR terminal),
  // switched by the toggle beside the window pill in the Editor header.
  const isMobile = useIsMobile();
  const mobileAppPane = useUIStore(s => s.mobileAppPane);

  // Derive the workbench view from BOX TRUTH, never localStorage. Auto-open
  // the workbench ONLY when a dev server is actually serving this app — a
  // read-only probe, no process started, no localStorage flag. The old
  // version restored an `apps-editing` flag from localStorage, which
  // auto-opened the workbench (and its terminals) over an empty box and
  // disagreed with the green dot — the exact multi-source drift §13.11 bans.
  // Editing a stopped app is a deliberate click now, not a restored side
  // effect.
  //
  // Until that probe answers, an unpublished app is not yet "never built":
  // it may be about to open its running dev server instead.
  const [devCheckedFor, setDevCheckedFor] = useState<string | null>(null);

  // WHEN THIS TAB MAY READ THE REPO AND THE BOX.
  //
  // Files, status, branches and the dev-server probe are git- or
  // sandbox-backed (3.4–3.7 s each on prod) and none is on screen while the
  // published app opens. Fired on mount, by every app tab including the
  // background ones, they queued on 1-vCPU instances in front of what the
  // person was waiting for. So: the front tab only, once its published app
  // has loaded (or after a fallback), and at once when nothing is loading —
  // an unpublished app, the workbench, a dev server already serving. A
  // background tab reads when it is brought to the front.
  const awaitingPublishedPaint = isAwaitingPublishedPaint({
    editing,
    publishedSha,
    pubLoaded,
    devRunning,
  });
  const [paintWaitOver, setPaintWaitOver] = useState(false);
  useEffect(() => {
    if (!isFrontTab || !awaitingPublishedPaint) return;
    const timer = setTimeout(
      () => setPaintWaitOver(true),
      APP_OPEN_FALLBACK_MS,
    );
    return () => clearTimeout(timer);
  }, [isFrontTab, awaitingPublishedPaint]);
  const repoReadsReady = appTabReadsReady({
    isFrontTab,
    appKnown: !!app,
    awaitingPublishedPaint,
    waitOver: paintWaitOver,
  });
  // The page's other boot-time reads wait on the same moment (app-open-gate).
  useEffect(() => {
    if (isFrontTab && app && !awaitingPublishedPaint) settleAppOpen();
  }, [isFrontTab, app, awaitingPublishedPaint]);

  const devProbedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceId || !repoReadsReady) return;
    if (devProbedFor.current === appId) return;
    devProbedFor.current = appId;
    void useAppsStore
      .getState()
      .checkDevStatus(workspaceId, appId)
      .then(() => {
        setDevCheckedFor(appId);
        const p = useAppsStore.getState().previewByApp[appId];
        if (p?.mode === "dev" && p.url && !editing) {
          setEditing(workspaceId, appId, true);
        }
      });
    // Run once per app open; `editing` is deliberately not a dependency —
    // exiting dev mode clears it, and re-entering here would fight it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, workspaceId, repoReadsReady]);

  // Entering edit mode is "modifying the content" for an app tab: it pins
  // the tab (consoleStore's preview invariant), so a workbench with a dev
  // server and terminals is never replaced by the next app you click. A
  // merely viewed app stays a preview tab, like a file you only looked at.
  useEffect(() => {
    if (editing) useConsoleStore.getState().updateDirty(_tabId, true);
  }, [editing, _tabId]);

  // The consumer view's token is short-lived, so it is fetched when this app
  // is opened for viewing and again whenever a publish moves the app on.
  useEffect(() => {
    if (!editing && app?.publishedSha && workspaceId) {
      // A token UrlSync prefetched, or one this tab already holds for this
      // publish, is used as is.
      void fetchViewUrl(workspaceId, appId, { reuseFresh: true });
    }
  }, [editing, app?.publishedSha, workspaceId, appId, fetchViewUrl]);
  // Keep the tab's URL handle honest: a top-level app is addressed by its
  // slug (/apps/<slug>), a nested one by its id (a nested folder name may
  // be shared by another app; an id never is). A move updates it in place.
  useEffect(() => {
    if (!app) return;
    const ref = appUrlRef(app);
    const slug = ref === app.id ? undefined : ref;
    useConsoleStore.setState(state => {
      const t = state.tabs[_tabId];
      if (t?.metadata && t.metadata.appSlug !== slug) t.metadata.appSlug = slug;
    });
  }, [app, _tabId]);

  // Remembers the preview/terminal split per browser, so a terminal you
  // sized stays sized — one you have to re-drag every visit is one you stop
  // using.
  const workspaceLayout = useDefaultLayout({
    id: "apps:workspace-vertical",
    storage: localStorage,
  });

  const checkDevStatus = useAppsStore(s => s.checkDevStatus);
  // The preview chip and iframe are CLIENT state; the server is the truth.
  // While a dev session is believed live, verify every 15s — Ctrl-C in the
  // dev terminal, a crash, or a recycled sandbox all flip the workbench to
  // the launch state within one beat instead of showing a stale "live".
  useEffect(() => {
    if (!workspaceId || !editing) return;
    // Immediately on entering the workbench: DISCOVER a server that is
    // already running (started elsewhere, or client state lost) instead of
    // asking the user to "start" it. Then keep verifying while editing —
    // the same probe notices Ctrl-C/crashes and flips the other way.
    void checkDevStatus(workspaceId, appId);
    const timer = setInterval(
      () => void checkDevStatus(workspaceId, appId),
      15_000,
    );
    return () => clearInterval(timer);
  }, [workspaceId, appId, editing, checkDevStatus]);

  const fetchApps = useAppsStore(s => s.fetchApps);
  const fetchFiles = useAppsStore(s => s.fetchFiles);
  const fetchStatus = useAppsStore(s => s.fetchStatus);
  const fetchHistory = useAppsStore(s => s.fetchHistory);
  const fetchBranches = useAppsStore(s => s.fetchBranches);
  const startDevPreview = useAppsStore(s => s.startDevPreview);
  const stopDev = useAppsStore(s => s.stopDev);

  const [historyAnchor, setHistoryAnchor] = useState<null | HTMLElement>(null);
  const [shareOpen, setShareOpen] = useState(false);
  // Bumping this remounts the preview iframe — a plain page refresh.
  const [previewNonce, setPreviewNonce] = useState(0);

  const { pubIframeRef, seedKey, seededSearch } = usePublishedFrameBridge({
    tabId: _tabId,
    previewNonce,
    viewUrl,
    editing,
  });

  useEffect(() => {
    if (!workspaceId) return;
    if (!app) void fetchApps(workspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, appId]);
  const repoReadFor = useRef<string | null>(null);
  useEffect(() => {
    if (!workspaceId || !repoReadsReady) return;
    if (repoReadFor.current === appId) return;
    repoReadFor.current = appId;
    void fetchFiles(workspaceId, appId);
    void fetchStatus(workspaceId, appId);
    void fetchBranches(workspaceId, appId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, appId, repoReadsReady]);

  // Repo-wide, deliberately: one worktree serves every app in the monorepo, so
  // Discard throws away the repo-wide set and a branch switch has to get past
  // it. Gating this on the app's own slice disabled the only escape hatch
  // exactly when the blocking file belonged to a different app.
  // Same "prefer the active chat's branch" logic as the sidebar's Version
  // control section: if the conversation you're currently chatting in has
  // already committed work on this app, Preview build should build THAT
  // branch — your own separate worktree always starts on main, so building
  // it while a chat is actively working here silently renders stale content.
  const activeChatId = useRealtimeStore(s => s.activeChatId);
  const activeChatBranch = (branches ?? []).find(
    b => b.name === `chat/${activeChatId}`,
  );

  if (!workspaceId) return null;

  // The dev-mode preview: build log while booting, the live iframe, or the
  // getting-started copy. Shared by the desktop split and the phone layout.
  const previewPane = (
    <DevPreviewPane
      workspaceId={workspaceId}
      appId={appId}
      appTitle={app?.title}
      preview={preview}
      hiddenPaused={hiddenPaused}
      previewNonce={previewNonce}
    />
  );

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Toolbar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          flexWrap: "wrap",
        }}
      >
        {/* The window pill already carries the title on a phone. */}
        {!isMobile && (
          <Typography variant="subtitle2" noWrap sx={{ maxWidth: 240 }}>
            {app?.title ?? "App"}
          </Typography>
        )}
        {devRunning && (
          <Chip
            label="live · HMR"
            size="small"
            color="success"
            variant="outlined"
          />
        )}
        <AppPublishedChip
          workspaceId={workspaceId}
          appId={appId}
          publishedSha={publishedSha}
          publishedAt={app?.publishedAt}
          liveUrl={liveUrl}
          building={preview?.building}
          onPublish={() => void publishApp(workspaceId, appId)}
        />
        <Box sx={{ flex: 1 }} />
        {/* ONE dev toggle in the query-runner's language: blue Play →
            "Start dev" when stopped, red Stop → "Stop dev" while running.
            Restart is gone — stop + start covers it, and agents restart
            through their own tools. */}
        <Tooltip
          title={
            devRunning
              ? "Stop the dev server. All terminal sessions die with it; the sandbox keeps running."
              : "Live preview: keeps the app running in its sandbox so your edits show up instantly, with no rebuild step."
          }
        >
          <span>
            <Button
              size="small"
              variant="contained"
              color={devRunning ? "error" : "primary"}
              startIcon={
                preview?.building ? (
                  <CircularProgress size={14} color="inherit" />
                ) : devRunning ? (
                  <StopIcon size={12} fill="currentColor" />
                ) : (
                  <PlayIcon size={14} />
                )
              }
              disabled={preview?.building}
              onClick={() => {
                if (devRunning) {
                  void stopDev(workspaceId, appId);
                } else {
                  setEditing(workspaceId, appId, true);
                  void startDevPreview(workspaceId, appId);
                }
              }}
            >
              {preview?.building
                ? "Starting..."
                : devRunning
                  ? "Stop dev"
                  : "Start dev"}
            </Button>
          </span>
        </Tooltip>
        <Tooltip
          title={
            activeChatBranch
              ? `Publish: merge ${activeChatBranch.name} into main, build from main, and deploy. Everyone sees the result; rolling back is instant.`
              : "Publish: build from main and deploy. Everyone sees the result; rolling back is instant."
          }
        >
          <span>
            <Button
              size="small"
              variant="outlined"
              disabled={preview?.building}
              onClick={() => void publishApp(workspaceId, appId)}
            >
              {preview?.building ? "Working..." : "Publish"}
            </Button>
          </span>
        </Tooltip>
        <Tooltip
          title={
            app?.publishedSha
              ? "Share the fullscreen published app"
              : "Publish the app before sharing it"
          }
        >
          <span>
            {isMobile ? (
              <IconButton
                size="small"
                aria-label="Share app"
                disabled={!app?.publishedSha}
                onClick={() => setShareOpen(true)}
              >
                <ShareIcon size={16} />
              </IconButton>
            ) : (
              <Button
                size="small"
                variant="outlined"
                startIcon={<ShareIcon size={15} />}
                disabled={!app?.publishedSha}
                onClick={() => setShareOpen(true)}
              >
                Share
              </Button>
            )}
          </span>
        </Tooltip>
        {!isMobile && (
          <Tooltip title={`History (${status?.branch ?? "main"})`}>
            <IconButton
              size="small"
              onClick={e => {
                setHistoryAnchor(e.currentTarget);
                void fetchHistory(workspaceId, appId);
              }}
            >
              <HistoryIcon size={16} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Open the preview in a new tab">
          <span>
            <IconButton
              size="small"
              aria-label="Open the preview in a new tab"
              disabled={!(editing ? preview?.url : liveUrl)}
              onClick={() => {
                const url = editing ? preview?.url : liveUrl;
                if (url) window.open(url, "_blank", "noopener");
              }}
            >
              <ExternalLinkIcon size={16} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Reload the app preview">
          <span>
            <IconButton
              size="small"
              aria-label="Reload the app preview"
              disabled={!(editing ? preview?.url : viewUrl)}
              onClick={() => setPreviewNonce(n => n + 1)}
            >
              <RefreshIcon size={16} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {preview?.error && (
        <Alert
          severity="error"
          onClose={() => {
            useAppsStore.setState(s => {
              const p = s.previewByApp[appId];
              if (p) p.error = null;
            });
          }}
          sx={{
            borderRadius: 0,
            whiteSpace: "pre-wrap",
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {preview.error}
        </Alert>
      )}

      {/* Preview / getting started, over the terminal */}
      {/* Two modes, two layouts. VIEWING is for consuming: the published
          build (or an honest "never deployed" disclaimer) fills the pane and
          there is NO terminal — a shell is a workbench tool, and mounting one
          under an app you are merely looking at both wastes the space and
          suggests the machine is part of viewing. DEV MODE is the workbench:
          preview on top, terminal below. */}
      {!editing ? (
        <Box
          sx={{ flex: 1, minHeight: 0, display: "flex", position: "relative" }}
        >
          {viewUrl ? (
            <>
              {/* Consumer view: the PUBLISHED app, which is what everyone who
                  is not working on it should see. It comes from the
                  deployment store, so opening someone's app costs a static
                  file read and starts no machine — the same reason a hundred
                  viewers can open one app without a hundred microVMs.

                  No allow-same-origin while this is served from Mako's own
                  origin: granting it would hand app code our origin and let
                  it out of the sandbox entirely. On the app's own origin
                  (APPS_ORIGIN_BASE) the flag is added, because that origin
                  is foreign and it is what lets the browser cache work. */}
              <iframe
                key={`pub-${seedKey}`}
                ref={pubIframeRef}
                title={`${app?.title ?? "App"} (published)`}
                // The view URL never carries a query of its own; the app's
                // rides on it so the SDK reads it at mount (the preview route
                // resolves the asset from the path alone).
                src={
                  seededSearch
                    ? viewUrl +
                      (viewUrl.includes("?")
                        ? `&${seededSearch.slice(1)}`
                        : seededSearch)
                    : viewUrl
                }
                sandbox={appFrameSandbox(viewUrl)}
                onLoad={() => setPubLoadedUrl(viewUrl)}
                style={{
                  border: 0,
                  width: "100%",
                  height: "100%",
                  // Visible from the start, ABOVE the opening card. Until the
                  // app's HTML paints, the frame is transparent and the card
                  // shows through it; the app's own boot skeleton then
                  // covers it the moment index.html parses. The frame used
                  // to be held at opacity 0 until onLoad — after the whole
                  // bundle — so that skeleton was never seen (5+ s of
                  // "Opening…" on prod for a 0.5 s app).
                  position: "relative",
                  zIndex: 1,
                  background: "transparent",
                  // No colorScheme here. The frame's color-scheme becomes the
                  // app's prefers-color-scheme, so pinning it to "light" made
                  // every system-following app light. Mako never sets one on
                  // <html>, so frame and app document are both "normal"
                  // before the app paints and the canvas stays transparent.
                }}
              />
              {!pubLoaded && (
                // Under the frame, and gone once it has loaded, so an app
                // without a background never shows the card through it.
                <Box
                  sx={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    zIndex: 0,
                  }}
                >
                  <AppOpeningState title={app?.title} />
                </Box>
              )}
            </>
          ) : publishedSha && viewUrlError ? (
            <EntityLoadErrorState
              error={viewUrlError}
              entityLabel="app"
              onRetry={
                workspaceId
                  ? () => void fetchViewUrl(workspaceId, appId)
                  : undefined
              }
            />
          ) : publishedSha ||
            (!app && appsLoading) ||
            devCheckedFor !== appId ? (
            // Built, or not known yet: the token, the app list or the
            // dev-server probe is still in flight. Never the never-built
            // screen — it offered "Launch dev mode" on every published app
            // for as long as its view token took.
            <AppOpeningState title={app?.title} />
          ) : (
            // Never deployed: say so plainly, and make the one meaningful
            // next action the obvious thing on the page.
            <Box
              sx={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                p: 4,
                textAlign: "center",
              }}
            >
              <Typography variant="h6">{app?.title ?? "App"}</Typography>
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                  maxWidth: 440,
                }}
              >
                This app has never been built and deployed, so there is nothing
                to view yet. Launch dev mode to work on it — a real sandbox with
                a live preview and a terminal — then publish when it is ready
                for everyone else.
              </Typography>
              <Button
                variant="contained"
                size="large"
                startIcon={<TerminalIcon size={18} />}
                onClick={() => {
                  setEditing(workspaceId, appId, true);
                  void startDevPreview(workspaceId, appId);
                }}
              >
                Launch dev mode
              </Button>
            </Box>
          )}
        </Box>
      ) : isMobile ? (
        // Phone: preview and terminal are the two halves of the toggle in
        // the Editor header; both stay mounted so switching costs nothing.
        <>
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: mobileAppPane === "preview" ? "flex" : "none",
              flexDirection: "column",
            }}
          >
            {previewPane}
          </Box>
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: mobileAppPane === "terminal" ? "block" : "none",
            }}
          >
            <TerminalTabs appId={appId} workspaceId={workspaceId} />
          </Box>
        </>
      ) : (
        <Group
          orientation="vertical"
          defaultLayout={workspaceLayout.defaultLayout}
          onLayoutChanged={workspaceLayout.onLayoutChanged}
          style={{ flex: 1, minHeight: 0 }}
        >
          <Panel id="preview" defaultSize="70%" minSize="20%">
            {previewPane}
          </Panel>

          <TerminalResizeHandle elementRef={guardSeparatorDrag} />

          <Panel
            id="terminal"
            defaultSize="30%"
            minSize="8%"
            collapsible
            collapsedSize="0%"
          >
            <TerminalTabs appId={appId} workspaceId={workspaceId} />
          </Panel>
        </Group>
      )}

      <AppHistoryPopover
        anchorEl={historyAnchor}
        onClose={() => setHistoryAnchor(null)}
        workspaceId={workspaceId}
        appId={appId}
        slug={app?.slug}
        branch={status?.branch ?? "main"}
        publishedSha={app?.publishedSha}
      />
      {app && (
        <ShareDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          resourceType="app"
          resourceId={app.id}
          resourceName={app.title}
          ownerId={app.owner_id}
          access={app.access ?? "workspace"}
          workspaceRole={app.workspaceRole ?? "viewer"}
          publicShare={app.publicShare}
          chatEnabled={app.chatEnabled === true}
          canManage={
            !app.owner_id || app.owner_id === user?.id || isWorkspaceAdmin
          }
          onSharingChanged={changes => {
            useAppsStore.setState(state => {
              const currentApp = state.apps.find(item => item.id === app.id);
              if (!currentApp) return;
              if (changes.access) currentApp.access = changes.access;
              if (changes.workspaceRole) {
                currentApp.workspaceRole = changes.workspaceRole;
              }
              if (changes.publicShare) {
                currentApp.publicShare = changes.publicShare;
              }
              if (changes.chatEnabled !== undefined) {
                currentApp.chatEnabled = changes.chatEnabled;
              }
            });
          }}
        />
      )}
    </Box>
  );
}
