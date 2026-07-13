import { useState, FormEvent, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
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
import { useAuth } from "../hooks/useAuth";
import { authClient } from "../lib/auth-client";
import { AuthLayout } from "./AuthLayout";
import { trackEvent } from "../lib/analytics";
import {
  supportsDesktopBrowserAuth,
  startDesktopBrowserAuth,
} from "../lib/desktop";

interface RegisterPageProps {
  onSwitchToLogin: () => void;
}

export function RegisterPage({ onSwitchToLogin }: RegisterPageProps) {
  const { register, loginWithOAuth, error, loading, clearError } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

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

  // Pre-fill email from URL params (e.g., from invite page)
  useEffect(() => {
    const emailParam = searchParams.get("email");
    if (emailParam) {
      setEmail(emailParam);
    }
  }, [searchParams]);

  const validateForm = () => {
    const errors: Record<string, string> = {};

    if (!email) {
      errors.email = "Email is required";
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      errors.email = "Please enter a valid email";
    }

    if (!password) {
      errors.password = "Password is required";
    } else if (password.length < 8) {
      errors.password = "Password must be at least 8 characters long";
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    if (!validateForm()) return;

    try {
      const { requiresVerification } = await register({
        email,
        password,
      });

      trackEvent("sign_up", { method: "email" });

      if (requiresVerification) {
        navigate(`/verify-email?email=${encodeURIComponent(email)}`);
      }
    } catch {
      // Error displayed in UI via error state from context
    }
  };

  const handleOAuthLogin = (provider: "google" | "github") => {
    clearError();
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
      title="Create your free account"
      subtitle={
        isOAuthEnabled ? "Connect to Mako with:" : "Sign up with your email:"
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={clearError}>
          {error}
        </Alert>
      )}

      {browserAuthStarted && (
        <Alert severity="info" sx={{ mb: 3 }}>
          Finish signing up using your browser. This window will log in
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
          visible address bar, no password manager). All sign-up is handed to
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
            For your security, Mako Desktop creates your account through your
            web browser, where you can check the address bar and use your
            password manager.
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
              Or continue with email
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
              placeholder="youremail@email.com"
            />
          </Box>

          <Box sx={{ mb: 2.5 }}>
            <Typography
              variant="body2"
              sx={{ fontWeight: 500, mb: 1, color: "text.primary" }}
            >
              Password
            </Typography>
            <TextField
              fullWidth
              size="small"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              error={!!formErrors.password}
              helperText={formErrors.password}
              disabled={loading}
              autoComplete="new-password"
              placeholder="Enter a unique password"
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
            {loading ? "Creating account..." : "Continue"}
          </Button>
        </form>
      )}

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mt: 2, lineHeight: 1.5 }}
      >
        By creating an account you agree to the{" "}
        <Link href="#" color="text.secondary">
          Terms of Service
        </Link>{" "}
        and our{" "}
        <Link href="#" color="text.secondary">
          Privacy Policy
        </Link>
        .
      </Typography>

      <Box sx={{ textAlign: "center", mt: 4 }}>
        <Typography variant="body2" color="text.secondary">
          Already have an account?{" "}
          <Link
            component="button"
            variant="body2"
            onClick={e => {
              e.preventDefault();
              onSwitchToLogin();
            }}
            disabled={loading}
            sx={{ textDecoration: "none" }}
          >
            Log in
          </Link>
        </Typography>
      </Box>
    </AuthLayout>
  );
}
