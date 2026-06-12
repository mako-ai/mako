import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Box,
  Button,
  CircularProgress,
  Paper,
  TextField,
  Typography,
} from "@mui/material";
import { Lock } from "lucide-react";
import PublicDashboardViewer, {
  type PublicDashboardContent,
} from "../components/public/PublicDashboardViewer";
import PublicAppViewer, {
  type PublicAppContent,
} from "../components/public/PublicAppViewer";

/**
 * Anonymous viewer for public share links (/share/:token).
 *
 * Rendered outside AuthWrapper — no session, no workspace context. Talks to
 * the intentionally-public /api/share/:token endpoints directly (snapshot
 * data only; raw fetch on purpose, apiClient is session/workspace-bound).
 */

interface ShareMeta {
  type: "dashboard" | "app";
  title: string;
  passwordRequired: boolean;
  unlocked: boolean;
}

type ShareContent = PublicDashboardContent | PublicAppContent;

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
        <Typography variant="body2" color="text.secondary">
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
          <Typography variant="body2" color="text.secondary">
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
        <Typography color="text.secondary">Nothing to show.</Typography>
      </Box>
    );
  }

  if (content.type === "dashboard") {
    return (
      <PublicDashboardViewer
        token={token}
        content={content}
        reloadContent={async () => {
          const next = await loadContent();
          if (next && next.type === "dashboard") {
            setContent(next);
            return next;
          }
          return null;
        }}
      />
    );
  }

  return <PublicAppViewer token={token} content={content} />;
}
