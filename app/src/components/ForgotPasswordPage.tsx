import { useState, FormEvent } from "react";
import { Box, TextField, Button, Typography, Alert, Link } from "@mui/material";
import { authClient } from "../lib/auth-client";

interface ForgotPasswordPageProps {
  onBackToLogin: () => void;
}

export function ForgotPasswordPage({ onBackToLogin }: ForgotPasswordPageProps) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const validateForm = () => {
    const errors: Record<string, string> = {};

    if (!email) {
      errors.email = "Email is required";
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      errors.email = "Please enter a valid email";
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!validateForm()) return;

    setLoading(true);
    try {
      await authClient.requestPasswordReset(email);
      setSuccess(true);
    } catch {
      // We show success even on error for security (don't reveal if email exists)
      setSuccess(true);
    } finally {
      setLoading(false);
    }
  };

  if (success) {
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
          <Box sx={{ position: "relative", zIndex: 1 }}>
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
              sx={{ fontWeight: 600, color: "#fff", lineHeight: 1.2 }}
            >
              Query your data
              <br />
              in seconds.
            </Typography>
          </Box>
        </Box>

        {/* Right Side - Success Message */}
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
          <Box sx={{ width: "100%", maxWidth: 380, textAlign: "center" }}>
            <Typography
              variant="h4"
              sx={{ fontWeight: 600, color: "#fff", mb: 2 }}
            >
              Check Your Email
            </Typography>
            <Typography variant="body2" sx={{ color: "#888", mb: 4 }}>
              If an account exists with{" "}
              <strong style={{ color: "#fff" }}>{email}</strong>, you will
              receive a password reset link shortly.
            </Typography>
            <Typography variant="body2" sx={{ color: "#666", mb: 4 }}>
              Please check your inbox and spam folder.
            </Typography>

            <Button
              fullWidth
              variant="contained"
              size="large"
              onClick={onBackToLogin}
              sx={{
                py: 1.5,
                bgcolor: "#00c896",
                color: "#000",
                fontWeight: 600,
                "&:hover": { bgcolor: "#00b085" },
              }}
            >
              Back to Login
            </Button>
          </Box>
        </Box>
      </Box>
    );
  }

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
        <Box sx={{ position: "relative", zIndex: 1 }}>
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
            sx={{ fontWeight: 600, color: "#fff", lineHeight: 1.2 }}
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
            Forgot Password
          </Typography>
          <Typography variant="body2" sx={{ color: "#888", mb: 4 }}>
            Enter your email address and we'll send you a link to reset your
            password.
          </Typography>

          {error && (
            <Alert
              severity="error"
              sx={{ mb: 3 }}
              onClose={() => setError(null)}
            >
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit}>
            <Box sx={{ mb: 2.5 }}>
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
                placeholder="you@example.com"
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

            <Button
              type="submit"
              fullWidth
              variant="contained"
              size="large"
              disabled={loading}
              sx={{
                py: 1.5,
                bgcolor: "#00c896",
                color: "#000",
                fontWeight: 600,
                "&:hover": { bgcolor: "#00b085" },
                "&.Mui-disabled": { bgcolor: "#222", color: "#555" },
              }}
            >
              {loading ? "Sending..." : "Send Reset Link"}
            </Button>
          </form>

          <Box sx={{ textAlign: "center", mt: 4 }}>
            <Typography variant="body2" sx={{ color: "#888" }}>
              Remember your password?{" "}
              <Link
                component="button"
                variant="body2"
                onClick={e => {
                  e.preventDefault();
                  onBackToLogin();
                }}
                disabled={loading}
                sx={{
                  color: "#00c896",
                  textDecoration: "none",
                  "&:hover": { textDecoration: "underline" },
                }}
              >
                Back to login
              </Link>
            </Typography>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
