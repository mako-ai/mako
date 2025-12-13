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

  // Check if OAuth is enabled (disabled for PR preview deployments)
  const isOAuthEnabled = authClient.isOAuthEnabled();

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

      if (requiresVerification) {
        navigate(`/verify-email?email=${encodeURIComponent(email)}`);
      }
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
              Or continue with email
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
            placeholder="youremail@email.com"
          />
        </Box>

        <Box sx={{ mb: 2.5 }}>
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
