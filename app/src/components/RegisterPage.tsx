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
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        bgcolor: "#0a0a0a",
      }}
    >
      {/* Left Side - Branding */}
      <Box
        sx={{
          flex: 1,
          display: { xs: "none", md: "flex" },
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          px: 8,
          background:
            "linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #0a0a0a 100%)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Decorative elements */}
        <Box
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            opacity: 0.3,
            background:
              "radial-gradient(circle at 30% 50%, rgba(0, 255, 170, 0.1) 0%, transparent 50%)",
          }}
        />
        <Box
          sx={{
            position: "relative",
            zIndex: 1,
          }}
        >
          <Box
            component="img"
            src="/mako-icon.svg"
            alt="Mako"
            sx={{
              width: 64,
              height: "auto",
              mb: 4,
              filter: "brightness(0) invert(1)",
            }}
          />
          <Typography
            variant="h3"
            sx={{
              fontWeight: 600,
              color: "#fff",
              lineHeight: 1.2,
            }}
          >
            Query your data
            <br />
            in seconds.
          </Typography>
        </Box>
      </Box>

      {/* Right Side - Form */}
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          px: { xs: 3, sm: 6 },
          py: 4,
          bgcolor: "#0f0f0f",
        }}
      >
        <Box sx={{ width: "100%", maxWidth: 380 }}>
          <Typography
            variant="h4"
            sx={{ fontWeight: 600, color: "#fff", mb: 1 }}
          >
            Create your free account
          </Typography>
          <Typography variant="body2" sx={{ color: "#888", mb: 4 }}>
            Connect to Mako with:
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 3 }} onClose={clearError}>
              {error}
            </Alert>
          )}

          {/* Social Login Buttons */}
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, mb: 3 }}>
            <Button
              fullWidth
              variant="outlined"
              startIcon={<GoogleIcon />}
              onClick={() => handleOAuthLogin("google")}
              disabled={loading}
              sx={{
                py: 1.25,
                borderColor: "#333",
                color: "#fff",
                bgcolor: "#1a1a1a",
                "&:hover": {
                  borderColor: "#555",
                  bgcolor: "#222",
                },
              }}
            >
              Google
            </Button>
            <Button
              fullWidth
              variant="outlined"
              startIcon={<GitHubIcon />}
              onClick={() => handleOAuthLogin("github")}
              disabled={loading}
              sx={{
                py: 1.25,
                borderColor: "#333",
                color: "#fff",
                bgcolor: "#1a1a1a",
                "&:hover": {
                  borderColor: "#555",
                  bgcolor: "#222",
                },
              }}
            >
              GitHub
            </Button>
          </Box>

          <Divider sx={{ my: 3, "&::before, &::after": { borderColor: "#333" } }}>
            <Typography
              variant="body2"
              sx={{ color: "#666", textTransform: "uppercase", fontSize: 11, letterSpacing: 1 }}
            >
              Or continue with email
            </Typography>
          </Divider>

          <form onSubmit={handleSubmit}>
            <Box sx={{ mb: 2 }}>
              <Typography variant="body2" sx={{ color: "#fff", mb: 0.5 }}>
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
                sx={{
                  "& .MuiOutlinedInput-root": {
                    bgcolor: "#1a1a1a",
                    "& fieldset": { borderColor: "#333" },
                    "&:hover fieldset": { borderColor: "#555" },
                    "&.Mui-focused fieldset": { borderColor: "#00ffaa" },
                  },
                  "& .MuiInputBase-input": { color: "#fff", py: 1.25 },
                }}
              />
            </Box>

            <Box sx={{ mb: 2.5 }}>
              <Typography variant="body2" sx={{ color: "#fff", mb: 0.5 }}>
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
                sx={{
                  "& .MuiOutlinedInput-root": {
                    bgcolor: "#1a1a1a",
                    "& fieldset": { borderColor: "#333" },
                    "&:hover fieldset": { borderColor: "#555" },
                    "&.Mui-focused fieldset": { borderColor: "#00ffaa" },
                  },
                  "& .MuiInputBase-input": { color: "#fff", py: 1.25 },
                }}
                slotProps={{
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          aria-label="toggle password visibility"
                          onClick={() => setShowPassword(!showPassword)}
                          edge="end"
                          size="small"
                          sx={{ color: "#888" }}
                        >
                          {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
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
              sx={{
                py: 1.5,
                bgcolor: "#333",
                color: "#888",
                "&:hover": { bgcolor: "#444" },
                "&.Mui-disabled": { bgcolor: "#222", color: "#555" },
              }}
            >
              {loading ? "Creating account..." : "Continue"}
            </Button>
          </form>

          <Typography
            variant="caption"
            sx={{ color: "#666", display: "block", mt: 2, lineHeight: 1.5 }}
          >
            By creating an account you agree to the{" "}
            <Link href="#" sx={{ color: "#888" }}>
              Terms of Service
            </Link>{" "}
            and our{" "}
            <Link href="#" sx={{ color: "#888" }}>
              Privacy Policy
            </Link>
            .
          </Typography>

          <Box sx={{ textAlign: "center", mt: 4 }}>
            <Typography variant="body2" sx={{ color: "#888" }}>
              Already have an account?{" "}
              <Link
                component="button"
                variant="body2"
                onClick={e => {
                  e.preventDefault();
                  onSwitchToLogin();
                }}
                disabled={loading}
                sx={{
                  color: "#00c896",
                  textDecoration: "none",
                  "&:hover": { textDecoration: "underline" },
                }}
              >
                Log in
              </Link>
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
