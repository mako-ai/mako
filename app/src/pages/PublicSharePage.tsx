import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import {
  Box,
  Button,
  CircularProgress,
  Paper,
  TextField,
  Typography,
} from "@mui/material";
import { Lock } from "lucide-react";
import { appFrameMessageOrigin, appFrameSandbox } from "../lib/app-frame";
import { replaceLocation } from "../lib/replace-location";

/**
 * Anonymous viewer for public share links (/share/:token).
 *
 * Rendered outside AuthWrapper — no session, no workspace context. Talks to
 * the intentionally-public /api/share/:token endpoints directly (published
 * apps only; raw fetch on purpose, apiClient is session/workspace-bound).
 *
 * Two ways to show the app, chosen by the server:
 * - `appUrl` (per-app origins on, apps.md §31): the app lives on its own
 *   foreign origin, `https://<appId>.makousercontent.com`, under a token the
 *   share minted. This page frames it full screen with the same sandbox
 *   rules as inside Mako (app-frame.ts), so the browser cache works. The
 *   visitor stays on /share/<token>; the app's query is mirrored onto it.
 * - otherwise: navigate to `entry` on Mako's origin, as before.
 */

interface ShareMeta {
  type: "app";
  title: string;
  passwordRequired: boolean;
  unlocked: boolean;
}

interface PublicAppContent {
  kind: "app";
  title: string;
  published: boolean;
  entry: string;
  /** The app on its own origin, when the server serves it there. */
  appUrl?: string;
}

type ShareContent = PublicAppContent;

export default function PublicSharePage() {
  const { token = "" } = useParams<{ token: string }>();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [content, setContent] = useState<ShareContent | null>(null);
  const [password, setPassword] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const loadContent = useCallback(async (): Promise<ShareContent | null> => {
    const res = await fetch(`/api/share/${token}/content`, {
      credentials: "include",
    });
    const json = await res.json().catch(() => null);
    if (res.status === 401) return null; // password gate
    if (!res.ok || !json?.success) {
      throw new Error(json?.error || "Failed to load content");
    }
    return json.data as ShareContent;
  }, [token]);

  useEffect(() => {
    if (!token) {
      setError("Invalid share link");
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/share/${token}`, {
          credentials: "include",
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success) {
          throw new Error(json?.error || "Share link not found");
        }
        const metaData = json.data as ShareMeta;
        setMeta(metaData);
        if (!metaData.passwordRequired || metaData.unlocked) {
          setContent(await loadContent());
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load share");
      } finally {
        setLoading(false);
      }
    })();
  }, [token, loadContent]);

  // A git-backed app is already a complete built deployment. Navigate to its
  // token-gated entrypoint instead of framing it so the app owns the whole
  // browser viewport. The server sandboxes that document (opaque origin, so
  // app code never runs as Mako); a password share's assets and data ride
  // on a grant the served HTML's <base> carries, since the sandboxed page
  // cannot send the unlock cookie (api/src/routes/public-share.ts).
  useEffect(() => {
    if (content?.published && !content.appUrl) {
      replaceLocation(content.entry);
    }
  }, [content]);

  // Framed on the app's own origin: the query the app boots with comes from
  // this page's URL, and the app's own navigation (filters, tabs) is
  // mirrored back onto it so the address bar stays a link to what is shown.
  // Only the app's frame, at its own origin, is believed, and only the query
  // is taken.
  const [initialSearch] = useState(() => window.location.search);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const framed = !!(content?.published && content.appUrl);
  useEffect(() => {
    if (!framed) return;
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
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${search}`,
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [framed]);

  useEffect(() => {
    if (framed && content?.title) document.title = content.title;
  }, [framed, content?.title]);

  const handleUnlock = async () => {
    setUnlocking(true);
    setUnlockError(null);
    try {
      const res = await fetch(`/api/share/${token}/unlock`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        throw new Error(json?.error || "Incorrect password");
      }
      setContent(await loadContent());
      setMeta(m => (m ? { ...m, unlocked: true } : m));
    } catch (e) {
      setUnlockError(e instanceof Error ? e.message : "Incorrect password");
    } finally {
      setUnlocking(false);
    }
  };

  if (loading) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error || !meta) {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          gap: 1,
        }}
      >
        <Typography variant="h6">This link isn&apos;t available</Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {error || "The share link may have been disabled or rotated."}
        </Typography>
      </Box>
    );
  }

  // Password gate
  if (meta.passwordRequired && !content) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          bgcolor: "background.default",
        }}
      >
        <Paper
          sx={{
            p: 4,
            width: 360,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
          }}
        >
          <Lock size={28} />
          <Typography variant="h6">{meta.title}</Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            This {meta.type} is password protected.
          </Typography>
          <TextField
            fullWidth
            size="small"
            type="password"
            placeholder="Password"
            value={password}
            autoFocus
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && password && !unlocking) {
                void handleUnlock();
              }
            }}
            error={!!unlockError}
            helperText={unlockError}
          />
          <Button
            fullWidth
            variant="contained"
            disabled={!password || unlocking}
            onClick={() => void handleUnlock()}
          >
            {unlocking ? "Unlocking…" : "View"}
          </Button>
        </Paper>
      </Box>
    );
  }

  if (!content) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
        }}
      >
        <Typography
          sx={{
            color: "text.secondary",
          }}
        >
          Nothing to show.
        </Typography>
      </Box>
    );
  }

  if (!content.published) {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          gap: 1,
        }}
      >
        <Typography variant="h6">
          This app has not been published yet
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          Ask the owner to publish it before sharing the link.
        </Typography>
      </Box>
    );
  }

  if (content.appUrl) {
    const src =
      content.appUrl +
      (initialSearch
        ? (content.appUrl.includes("?") ? "&" : "?") + initialSearch.slice(1)
        : "");
    return (
      <Box
        sx={{
          position: "fixed",
          inset: 0,
          bgcolor: "background.default",
        }}
      >
        {/* allow-same-origin is added only because src is cross-origin to
            this page (app-frame.ts): the app gets its own origin, never
            Mako's. */}
        <iframe
          ref={frameRef}
          title={content.title || "App"}
          src={src}
          sandbox={appFrameSandbox(src)}
          onLoad={() => setFrameLoaded(true)}
          style={{
            border: 0,
            width: "100%",
            height: "100%",
            display: "block",
          }}
        />
        {!frameLoaded && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <CircularProgress />
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
      }}
    >
      <CircularProgress />
    </Box>
  );
}
