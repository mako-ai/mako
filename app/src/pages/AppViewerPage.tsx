/**
 * The page an app's live link opens: the published app, full screen, with a
 * chat beside it ("chat with app").
 *
 * `/api/workspaces/<ws>/apps/<id>/live/` redirects browser visits here. The
 * app itself still runs exactly as it does inside Mako: the published build
 * in a sandboxed, opaque-origin iframe loaded from a short-lived view-token
 * URL (an opaque origin cannot send cookies, so the cookie-authorized
 * `/live/` URL cannot be the iframe's source). The app's query string — its
 * filters — rides on the iframe URL at load, is mirrored back onto this
 * page's address bar as the app navigates, and is sent with each chat turn.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Navigate, useLocation, useParams } from "react-router";
import {
  Box,
  CircularProgress,
  Fab,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { MessageCircle } from "lucide-react";
import { useAuth } from "../contexts/auth-context";
import { appViewerKey, useAppViewerStore } from "../store/appViewerStore";
import { AppChatPanel } from "../components/AppChatPanel";
import { referrerKindOf, useAppUsageBeacon } from "../hooks/useAppUsageBeacon";
import { appFrameMessageOrigin, appFrameSandbox } from "../lib/app-frame";

const CHAT_OPEN_KEY = "mako:app-viewer-chat-open";
const CHAT_WIDTH_KEY = "mako:app-viewer-chat-width";
// Same bounds feel as the shell's chat pane; the app keeps at least
// APP_MIN_WIDTH so the panel can never squeeze it away.
const PANEL_DEFAULT_WIDTH = 420;
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 760;
const APP_MIN_WIDTH = 320;

function clampWidth(width: number): number {
  const viewportMax =
    typeof window === "undefined"
      ? PANEL_MAX_WIDTH
      : window.innerWidth - APP_MIN_WIDTH;
  return Math.round(
    Math.max(PANEL_MIN_WIDTH, Math.min(width, PANEL_MAX_WIDTH, viewportMax)),
  );
}

function readChatWidth(): number {
  try {
    const stored = Number(localStorage.getItem(CHAT_WIDTH_KEY));
    return stored > 0 ? clampWidth(stored) : PANEL_DEFAULT_WIDTH;
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

function writeChatWidth(width: number) {
  try {
    localStorage.setItem(CHAT_WIDTH_KEY, String(width));
  } catch {
    // Storage unavailable: the width just resets next visit.
  }
}

function readChatOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeChatOpen(open: boolean) {
  try {
    localStorage.setItem(CHAT_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Storage unavailable: the panel just won't remember its state.
  }
}

function centered(children: ReactNode) {
  return (
    <Box
      sx={{
        height: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 2,
        textAlign: "center",
      }}
    >
      {children}
    </Box>
  );
}

export default function AppViewerPage() {
  const { workspaceId = "", appId = "" } = useParams();
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));

  const viewer = useAppViewerStore(
    s => s.viewerByApp[appViewerKey(workspaceId, appId)],
  );
  const openViewer = useAppViewerStore(s => s.openViewer);
  const app =
    viewer?.status === "ready" && viewer.viewUrl
      ? {
          title: viewer.title ?? "App",
          viewUrl: viewer.viewUrl,
          chatEnabled: viewer.chatEnabled === true,
        }
      : null;
  const error = viewer?.status === "error" ? viewer.error : null;
  const [frameLoaded, setFrameLoaded] = useState(false);
  // Where the viewer came from — a link in Slack, a bookmark — read once.
  const [referrerKind] = useState(() =>
    referrerKindOf(document.referrer, window.location.origin),
  );
  useAppUsageBeacon({
    workspaceId,
    appId,
    active: !!app && frameLoaded,
    referrerKind,
  });
  const [chatOpen, setChatOpenState] = useState(readChatOpen);
  const setChatOpen = useCallback((open: boolean) => {
    setChatOpenState(open);
    writeChatOpen(open);
  }, []);

  // The query the app booted with; afterwards the app's own navigation is
  // the source of truth (mirrored from its navigate messages).
  const [initialSearch] = useState(() => {
    const params = new URLSearchParams(location.search);
    params.delete("raw");
    const search = params.toString();
    return search ? `?${search}` : "";
  });
  const appSearchRef = useRef(initialSearch);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!user || !workspaceId || !appId) return;
    void openViewer(workspaceId, appId);
  }, [user, workspaceId, appId, openViewer]);

  useEffect(() => {
    if (app?.title) document.title = app.title;
  }, [app?.title]);

  // The app reports its own navigation (filters, tabs) — keep the address
  // bar shareable and give the chat the state the viewer is looking at. Only
  // the app's frame is trusted, and only the query is taken.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      if (event.origin !== appFrameMessageOrigin(frame.src)) return;
      const data = event.data as { type?: unknown; search?: unknown } | null;
      if (
        data?.type !== "mako-app:navigate" ||
        typeof data.search !== "string"
      ) {
        return;
      }
      const search =
        data.search === "" || data.search.startsWith("?")
          ? data.search
          : `?${data.search}`;
      appSearchRef.current = search;
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${search}`,
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const getAppSearch = useCallback(() => appSearchRef.current, []);

  // Drag-to-resize, like the shell's chat pane divider. While dragging, the
  // iframe stops taking pointer events — otherwise it swallows the
  // pointermove events the moment the cursor crosses into the app.
  const [chatWidth, setChatWidth] = useState(readChatWidth);
  const [resizing, setResizing] = useState(false);
  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = chatWidth;
      let latest = startWidth;
      setResizing(true);
      const onMove = (e: PointerEvent) => {
        latest = clampWidth(startWidth + (startX - e.clientX));
        setChatWidth(latest);
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        setResizing(false);
        writeChatWidth(latest);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [chatWidth],
  );
  const nudgeWidth = useCallback((delta: number) => {
    setChatWidth(width => {
      const next = clampWidth(width + delta);
      writeChatWidth(next);
      return next;
    });
  }, []);

  if (authLoading) return centered(<CircularProgress />);
  if (!user) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }
  if (error) {
    return centered(<Typography color="text.secondary">{error}</Typography>);
  }

  const src = app
    ? app.viewUrl +
      (initialSearch
        ? (app.viewUrl.includes("?") ? "&" : "?") + initialSearch.slice(1)
        : "")
    : null;

  return (
    <Box
      sx={{
        height: "100dvh",
        display: "flex",
        bgcolor: "background.default",
        overflow: "hidden",
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0, position: "relative" }}>
        {src && (
          // No allow-same-origin while the app is served from Mako's own
          // origin: granting it would let app code out of the sandbox. On the
          // app's own (foreign) origin it is added, so the cache works.
          <iframe
            ref={frameRef}
            title={app?.title ?? "App"}
            src={src}
            sandbox={appFrameSandbox(src, "allow-scripts allow-forms")}
            onLoad={() => setFrameLoaded(true)}
            style={{
              border: 0,
              width: "100%",
              height: "100%",
              display: "block",
              opacity: frameLoaded ? 1 : 0,
              transition: "opacity 150ms ease",
              pointerEvents: resizing ? "none" : undefined,
            }}
          />
        )}
        {!frameLoaded && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CircularProgress />
          </Box>
        )}
        {app?.chatEnabled && !chatOpen && (
          <Fab
            variant="extended"
            color="primary"
            size="medium"
            onClick={() => setChatOpen(true)}
            sx={{ position: "absolute", right: 16, bottom: 16, gap: 1 }}
          >
            <MessageCircle size={18} />
            Ask
          </Fab>
        )}
      </Box>
      {app?.chatEnabled && chatOpen && !isMobile && (
        <Box
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat"
          aria-valuenow={chatWidth}
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuemax={PANEL_MAX_WIDTH}
          tabIndex={0}
          onPointerDown={startResize}
          onDoubleClick={() => {
            setChatWidth(PANEL_DEFAULT_WIDTH);
            writeChatWidth(PANEL_DEFAULT_WIDTH);
          }}
          onKeyDown={e => {
            if (e.key === "ArrowLeft") nudgeWidth(24);
            if (e.key === "ArrowRight") nudgeWidth(-24);
          }}
          sx={{
            flex: "0 0 4px",
            width: "4px",
            alignSelf: "stretch",
            cursor: "col-resize",
            touchAction: "none",
            bgcolor: resizing ? "primary.main" : "divider",
            transition: "background-color 0.2s ease",
            "&:hover, &:focus-visible": {
              bgcolor: "primary.main",
              outline: "none",
            },
          }}
        />
      )}
      {app?.chatEnabled && chatOpen && (
        <Box
          sx={
            isMobile
              ? { position: "fixed", inset: 0, zIndex: theme.zIndex.modal }
              : { width: chatWidth, flexShrink: 0, minWidth: 0 }
          }
        >
          <AppChatPanel
            workspaceId={workspaceId}
            appId={appId}
            appTitle={app.title}
            getAppSearch={getAppSearch}
            onClose={() => setChatOpen(false)}
          />
        </Box>
      )}
    </Box>
  );
}
