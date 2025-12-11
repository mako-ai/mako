import { useState, FormEvent, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  Box,
  TextField,
  Button,
  Typography,
  Alert,
  Link,
  IconButton,
  InputAdornment,
} from "@mui/material";
import { Visibility, VisibilityOff } from "@mui/icons-material";
import { authClient } from "../lib/auth-client";

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const email = searchParams.get("email") || "";
  const code = searchParams.get("code") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!email || !code) {
      setError("Invalid password reset link. Please request a new one.");
    }
  }, [email, code]);

  const validateForm = () => {
    const errors: Record<string, string> = {};

    if (!password) {
      errors.password = "Password is required";
    } else if (password.length < 8) {
      errors.password = "Password must be at least 8 characters";
    }

    if (!confirmPassword) {
      errors.confirmPassword = "Please confirm your password";
    } else if (password !== confirmPassword) {
      errors.confirmPassword = "Passwords do not match";
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
      await authClient.resetPassword(email, code, password);
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || "Failed to reset password. Please try again.");
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
              Password Reset!
            </Typography>
            <Typography variant="body2" sx={{ color: "#888", mb: 4 }}>
              Your password has been successfully reset. You can now login with
              your new password.
            </Typography>

            <Button
              fullWidth
              variant="contained"
              size="large"
              onClick={() => navigate("/login")}
              sx={{
                py: 1.5,
                bgcolor: "#00c896",
                color: "#000",
                fontWeight: 600,
                "&:hover": { bgcolor: "#00b085" },
              }}
            >
              Go to Login
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
            Reset Password
          </Typography>
          <Typography variant="body2" sx={{ color: "#888", mb: 4 }}>
            Enter your new password below.
          </Typography>

          {error && (
            <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {!email || !code ? (
            <Box sx={{ textAlign: "center" }}>
              <Typography variant="body2" sx={{ color: "#888", mb: 3 }}>
                This link appears to be invalid or expired.
              </Typography>
              <Button
                variant="outlined"
                onClick={() => navigate("/forgot-password")}
                sx={{
                  borderColor: "#333",
                  color: "#fff",
                  "&:hover": { borderColor: "#555", bgcolor: "#1a1a1a" },
                }}
              >
                Request New Reset Link
              </Button>
            </Box>
          ) : (
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
                  disabled
                  sx={{
                    "& .MuiOutlinedInput-root": {
                      bgcolor: "#1a1a1a",
                      "& fieldset": { borderColor: "#333" },
                    },
                    "& .MuiInputBase-input": { color: "#666", py: 1.25 },
                    "& .Mui-disabled": { WebkitTextFillColor: "#666" },
                  }}
                />
              </Box>

              <Box sx={{ mb: 2 }}>
                <Typography variant="body2" sx={{ color: "#fff", mb: 0.5 }}>
                  New Password
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
                  autoFocus
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

              <Box sx={{ mb: 2.5 }}>
                <Typography variant="body2" sx={{ color: "#fff", mb: 0.5 }}>
                  Confirm Password
                </Typography>
                <TextField
                  fullWidth
                  size="small"
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  error={!!formErrors.confirmPassword}
                  helperText={formErrors.confirmPassword}
                  disabled={loading}
                  autoComplete="new-password"
                  placeholder="Confirm your password"
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
                            aria-label="toggle confirm password visibility"
                            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                            edge="end"
                            size="small"
                            sx={{ color: "#888" }}
                          >
                            {showConfirmPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
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
                  bgcolor: "#00c896",
                  color: "#000",
                  fontWeight: 600,
                  "&:hover": { bgcolor: "#00b085" },
                  "&.Mui-disabled": { bgcolor: "#222", color: "#555" },
                }}
              >
                {loading ? "Resetting..." : "Reset Password"}
              </Button>
            </form>
          )}

          <Box sx={{ textAlign: "center", mt: 4 }}>
            <Typography variant="body2" sx={{ color: "#888" }}>
              <Link
                component="button"
                variant="body2"
                onClick={e => {
                  e.preventDefault();
                  navigate("/login");
                }}
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
