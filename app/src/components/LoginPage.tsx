import { useState, FormEvent } from "react";
import {
  Box,
  TextField,
  Button,
  Typography,
  Alert,
  Divider,
  Link,
  IconButton,
  InputAdornment,
} from "@mui/material";
import {
  Visibility,
  VisibilityOff,
  Google as GoogleIcon,
  GitHub as GitHubIcon,
} from "@mui/icons-material";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { handleInviteRedirectIfPresent } from "../utils/invite-redirect";
import { readReturnTo, stashReturnTo } from "../utils/return-to";
import { authClient } from "../lib/auth-client";
import { AuthLayout } from "./AuthLayout";
import { trackEvent } from "../lib/analytics";
import {
  supportsDesktopBrowserAuth,
  startDesktopBrowserAuth,
} from "../lib/desktop";

interface LoginPageProps {
  onSwitchToRegister: () => void;
  onForgotPassword: () => void;
}

export function LoginPage({
  onSwitchToRegister,
  onForgotPassword,
}: LoginPageProps) {
  const { login, loginWithOAuth, error, loading, clearError } = useAuth();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  // True after the desktop shell opened the system browser for sign-in
  const [browserAuthStarted, setBrowserAuthStarted] = useState(false);

  // Check if OAuth is enabled (disabled for PR preview deployments)
  const isOAuthEnabled = authClient.isOAuthEnabled();

  // Inside Mako Desktop, third-party logins happen in the system browser
  // (visible URL/certificates + the user's password manager), never in the
  // embedded window.
  const useBrowserAuth = supportsDesktopBrowserAuth();

  // Set by GET /api/auth/desktop/complete when a deep-link code is invalid,
  // expired, or already used (this page renders inside the desktop window).
  const desktopAuthFailed = searchParams.get("error") === "desktop_auth";

  const validateForm = () => {
    const errors: Record<string, string> = {};

    if (!email) {
      errors.email = "Email is required";
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      errors.email = "Please enter a valid email";
    }

    if (!password) {
      errors.password = "Password is required";
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    if (!validateForm()) return;

    try {
      await login({ email, password });
      trackEvent("login", { method: "email" });
      handleInviteRedirectIfPresent();
    } catch {
      // Error displayed in UI via error state from context
    }
  };

  const handleOAuthLogin = (provider: "google" | "github") => {
    clearError();
    // OAuth is a full-page round trip that lands back on "/", losing the
    // ?returnTo the API's login gate put on this URL — keep it for after.
    stashReturnTo(readReturnTo());
    if (useBrowserAuth) {
      void handleBrowserAuth();
      return;
    }
    loginWithOAuth(provider);
  };

  const handleBrowserAuth = async () => {
    clearError();
    trackEvent("desktop_auth_handoff", { step: "browser_opened" });
    await startDesktopBrowserAuth();
    setBrowserAuthStarted(true);
  };

  return (
    <AuthLayout
      title="Log in to your account"
      subtitle={
        isOAuthEnabled ? "Connect to Mako with:" : "Log in with your email:"
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={clearError}>
          {error}
        </Alert>
      )}

      {desktopAuthFailed && !browserAuthStarted && (
        <Alert severity="error" sx={{ mb: 3 }}>
          That desktop sign-in link expired or was already used. Please try
          again.
        </Alert>
      )}

      {browserAuthStarted && (
        <Alert severity="info" sx={{ mb: 3 }}>
          Finish signing in using your browser. This window will log in
          automatically once you&apos;re done.{" "}
          <Link
            component="button"
            type="button"
            variant="body2"
            onClick={() => void handleBrowserAuth()}
            sx={{ textDecoration: "none", verticalAlign: "baseline" }}
          >
            Reopen browser
          </Link>
        </Alert>
      )}

      {/* Desktop: credentials are never entered in the embedded window (no
          visible address bar, no password manager). All sign-in is handed to
          the system browser instead. */}
      {useBrowserAuth && (
        <Box>
          <Button
            fullWidth
            variant="contained"
            size="large"
            onClick={() => void handleBrowserAuth()}
            disabled={loading}
            sx={{ py: 1.5 }}
          >
            {browserAuthStarted
              ? "Reopen browser to continue"
              : "Continue in your browser"}
          </Button>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: 1.5, lineHeight: 1.5 }}
          >
            For your security, Mako Desktop signs you in through your web
            browser, where you can check the address bar and use your password
            manager.
          </Typography>
        </Box>
      )}

      {/* Social Login Buttons - Hidden when OAuth is disabled (PR previews) */}
      {!useBrowserAuth && isOAuthEnabled && (
        <>
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              gap: 1.5,
              mb: 3,
            }}
          >
            <Button
              fullWidth
              variant="outlined"
              startIcon={<GoogleIcon />}
              onClick={() => handleOAuthLogin("google")}
              disabled={loading}
              sx={{ py: 1.25 }}
            >
              Google
            </Button>
            <Button
              fullWidth
              variant="outlined"
              startIcon={<GitHubIcon />}
              onClick={() => handleOAuthLogin("github")}
              disabled={loading}
              sx={{ py: 1.25 }}
            >
              GitHub
            </Button>
          </Box>

          <Divider sx={{ my: 3 }}>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              Or log in with your email
            </Typography>
          </Divider>
        </>
      )}

      {!useBrowserAuth && (
        <form onSubmit={handleSubmit}>
          <Box sx={{ mb: 2 }}>
            <Typography
              variant="body2"
              sx={{ fontWeight: 500, mb: 1, color: "text.primary" }}
            >
              Email
            </Typography>
            <TextField
              fullWidth
              size="small"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              error={!!formErrors.email}
              helperText={formErrors.email}
              disabled={loading}
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
            />
          </Box>

          <Box sx={{ mb: 2.5 }}>
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                mb: 1,
              }}
            >
              <Typography
                variant="body2"
                sx={{ fontWeight: 500, color: "text.primary" }}
              >
                Password
              </Typography>
              <Link
                component="button"
                type="button"
                variant="body2"
                onClick={e => {
                  e.preventDefault();
                  onForgotPassword();
                }}
                disabled={loading}
                sx={{ textDecoration: "none" }}
              >
                Forgot Password?
              </Link>
            </Box>
            <TextField
              fullWidth
              size="small"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              error={!!formErrors.password}
              helperText={formErrors.password}
              disabled={loading}
              autoComplete="current-password"
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label="toggle password visibility"
                        onClick={() => setShowPassword(!showPassword)}
                        edge="end"
                        size="small"
                      >
                        {showPassword ? (
                          <VisibilityOff fontSize="small" />
                        ) : (
                          <Visibility fontSize="small" />
                        )}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />
          </Box>

          <Button
            type="submit"
            fullWidth
            variant="contained"
            size="large"
            disabled={loading}
            sx={{ py: 1.5 }}
          >
            {loading ? "Logging in..." : "Log in"}
          </Button>
        </form>
      )}

      <Box sx={{ textAlign: "center", mt: 4 }}>
        <Typography variant="body2" color="text.secondary">
          New to Mako?{" "}
          <Link
            component="button"
            variant="body2"
            onClick={e => {
              e.preventDefault();
              onSwitchToRegister();
            }}
            disabled={loading}
            sx={{ textDecoration: "none" }}
          >
            Sign up for an account
          </Link>
        </Typography>
      </Box>
    </AuthLayout>
  );
}
