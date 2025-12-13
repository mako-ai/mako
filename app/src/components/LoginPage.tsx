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
import { useAuth } from "../hooks/useAuth";
import { handleInviteRedirectIfPresent } from "../utils/invite-redirect";
import { authClient } from "../lib/auth-client";
import { AuthLayout } from "./AuthLayout";

interface LoginPageProps {
  onSwitchToRegister: () => void;
  onForgotPassword: () => void;
}

export function LoginPage({
  onSwitchToRegister,
  onForgotPassword,
}: LoginPageProps) {
  const { login, loginWithOAuth, error, loading, clearError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // Check if OAuth is enabled (disabled for PR preview deployments)
  const isOAuthEnabled = authClient.isOAuthEnabled();

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
      handleInviteRedirectIfPresent();
    } catch {
      // Error displayed in UI via error state from context
    }
  };

  const handleOAuthLogin = (provider: "google" | "github") => {
    clearError();
    loginWithOAuth(provider);
  };

  return (
    <AuthLayout
      title="Log in to your account"
      subtitle={
        isOAuthEnabled
          ? "Connect to Mako with:"
          : "Log in with your email:"
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={clearError}>
          {error}
        </Alert>
      )}

      {/* Social Login Buttons - Hidden when OAuth is disabled (PR previews) */}
      {isOAuthEnabled && (
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

      <form onSubmit={handleSubmit}>
        <Box sx={{ mb: 2 }}>
          <TextField
            fullWidth
            label="Email"
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
              justifyContent: "flex-end",
              mb: 0.5,
            }}
          >
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
            label="Password"
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
