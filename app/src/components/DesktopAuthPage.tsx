import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Link, Typography } from "@mui/material";
import CircularProgress from "@mui/material/CircularProgress";
import LaunchIcon from "@mui/icons-material/Launch";
import { Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { authClient } from "../lib/auth-client";
import { AuthLayout } from "./AuthLayout";
import { trackEvent } from "../lib/analytics";
import {
  clearPendingDesktopAuthChallenge,
  getPendingDesktopAuthChallenge,
  isValidDesktopAuthChallenge,
  setPendingDesktopAuthChallenge,
} from "../utils/desktop-auth-redirect";

/**
 * Browser-side handoff page for Mako Desktop sign-in (`/desktop-auth`).
 *
 * The desktop app opens the system browser here with a PKCE challenge.
 * Once the user is signed in (in this browser, with their password manager
 * and visible certificates), the page mints a one-time auth code bound to
 * the challenge and hands it back to the desktop app via a
 * `mako://auth?code=...` deep link.
 */

type HandoffState =
  | { status: "minting" }
  | { status: "ready"; code: string; expiresIn: number }
  | { status: "expired" }
  | { status: "error"; message: string };

function buildDeepLink(code: string): string {
  return `mako://auth?code=${encodeURIComponent(code)}`;
}

export function DesktopAuthPage() {
  const { user, loading } = useAuth();
  const [searchParams] = useSearchParams();

  // Prefer the challenge from the URL (fresh from the desktop app); fall back
  // to the one stashed before a login round trip. Captured once on mount:
  // minting clears the sessionStorage copy, and re-deriving on a later
  // re-render would wrongly flip the page into the "missing challenge" state.
  const [challenge] = useState<string | null>(() => {
    const queryChallenge = searchParams.get("challenge");
    return isValidDesktopAuthChallenge(queryChallenge)
      ? queryChallenge
      : getPendingDesktopAuthChallenge();
  });

  const [handoff, setHandoff] = useState<HandoffState>({ status: "minting" });
  const mintInFlight = useRef(false);

  const mintCode = useCallback(async () => {
    if (!challenge || mintInFlight.current) return;
    mintInFlight.current = true;
    setHandoff({ status: "minting" });
    try {
      const { code, expiresIn } =
        await authClient.createDesktopAuthCode(challenge);
      clearPendingDesktopAuthChallenge();
      setHandoff({ status: "ready", code, expiresIn });
      trackEvent("desktop_auth_handoff", { step: "code_minted" });
      // Hand the code to the desktop app. Browsers that block unattended
      // custom-scheme launches still show the explicit button below.
      window.location.href = buildDeepLink(code);
    } catch (err) {
      setHandoff({
        status: "error",
        message:
          err instanceof Error ? err.message : "Failed to prepare sign-in",
      });
    } finally {
      mintInFlight.current = false;
    }
  }, [challenge]);

  // Mint a code as soon as we know the user is signed in.
  useEffect(() => {
    if (!loading && user && challenge) {
      void mintCode();
    }
  }, [loading, user, challenge, mintCode]);

  // Flip to "expired" when the code's TTL elapses.
  useEffect(() => {
    if (handoff.status !== "ready") return;
    const timer = setTimeout(
      () => setHandoff({ status: "expired" }),
      handoff.expiresIn * 1000,
    );
    return () => clearTimeout(timer);
  }, [handoff]);

  // ── Render paths ───────────────────────────────────────────────────────────

  if (!challenge) {
    return (
      <AuthLayout
        title="Open Mako Desktop"
        subtitle="This page completes sign-in for the Mako desktop app."
      >
        <Alert severity="warning" sx={{ mb: 3 }}>
          This link is missing its sign-in challenge. Please open it from the
          Mako desktop app by choosing a sign-in option there.
        </Alert>
        <Typography variant="body2" color="text.secondary">
          Looking for the web app?{" "}
          <Link href="/login" sx={{ textDecoration: "none" }}>
            Log in here
          </Link>
        </Typography>
      </AuthLayout>
    );
  }

  if (loading) {
    return (
      <AuthLayout title="Open Mako Desktop">
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress />
        </Box>
      </AuthLayout>
    );
  }

  if (!user) {
    // Stash the challenge so we can resume after any login method —
    // including the full-page OAuth redirect round trip.
    setPendingDesktopAuthChallenge(challenge);
    return <Navigate to="/login" replace />;
  }

  return (
    <AuthLayout
      title="Open Mako Desktop"
      subtitle={`Signed in as ${user.email}`}
    >
      {handoff.status === "minting" && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            py: 2,
          }}
        >
          <CircularProgress size={24} />
          <Typography variant="body2" color="text.secondary">
            Preparing your desktop sign-in…
          </Typography>
        </Box>
      )}

      {handoff.status === "ready" && (
        <>
          <Typography variant="body2" sx={{ mb: 3, color: "text.secondary" }}>
            You&apos;re all set. Click the button below if Mako didn&apos;t open
            automatically.
          </Typography>
          <Button
            fullWidth
            variant="contained"
            size="large"
            startIcon={<LaunchIcon />}
            href={buildDeepLink(handoff.code)}
            sx={{ py: 1.5, mb: 2 }}
          >
            Open Mako
          </Button>
          <Typography variant="caption" color="text.secondary">
            This link is single-use and expires in {handoff.expiresIn} seconds.
            You can close this tab once the app opens.
          </Typography>
        </>
      )}

      {handoff.status === "expired" && (
        <>
          <Alert severity="info" sx={{ mb: 3 }}>
            That sign-in link expired. Request a new one below.
          </Alert>
          <Button
            fullWidth
            variant="contained"
            size="large"
            onClick={() => void mintCode()}
            sx={{ py: 1.5 }}
          >
            Request a new code
          </Button>
        </>
      )}

      {handoff.status === "error" && (
        <>
          <Alert severity="error" sx={{ mb: 3 }}>
            {handoff.message}
          </Alert>
          <Button
            fullWidth
            variant="contained"
            size="large"
            onClick={() => void mintCode()}
            sx={{ py: 1.5 }}
          >
            Try again
          </Button>
        </>
      )}

      <Box sx={{ mt: 4 }}>
        <Typography variant="body2" color="text.secondary">
          Nothing happening? Make sure the Mako desktop app is installed, or{" "}
          <Link href="/" sx={{ textDecoration: "none" }}>
            continue in the browser
          </Link>
          .
        </Typography>
      </Box>
    </AuthLayout>
  );
}
