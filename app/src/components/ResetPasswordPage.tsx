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
import { AuthLayout } from "./AuthLayout";

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
      <AuthLayout title="Password Reset!">
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 4 }}>
          Your password has been successfully reset. You can now login with your
          new password.
        </Typography>

        <Button
          fullWidth
          variant="contained"
          size="large"
          onClick={() => navigate("/login")}
          sx={{ py: 1.5 }}
        >
          Go to Login
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset Password"
      subtitle="Enter your new password below."
    >
      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!email || !code ? (
        <Box sx={{ textAlign: "center" }}>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 3 }}>
            This link appears to be invalid or expired.
          </Typography>
          <Button
            variant="outlined"
            onClick={() => navigate("/forgot-password")}
          >
            Request New Reset Link
          </Button>
        </Box>
      ) : (
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
              disabled
              sx={{
                "& .Mui-disabled": {
                  WebkitTextFillColor: "text.secondary",
                },
              }}
            />
          </Box>

          <Box sx={{ mb: 2 }}>
            <Typography
              variant="body2"
              sx={{ fontWeight: 500, mb: 1, color: "text.primary" }}
            >
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

          <Box sx={{ mb: 2.5 }}>
            <Typography
              variant="body2"
              sx={{ fontWeight: 500, mb: 1, color: "text.primary" }}
            >
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
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label="toggle confirm password visibility"
                        onClick={() =>
                          setShowConfirmPassword(!showConfirmPassword)
                        }
                        edge="end"
                        size="small"
                      >
                        {showConfirmPassword ? (
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
            {loading ? "Resetting..." : "Reset Password"}
          </Button>
        </form>
      )}

      <Box sx={{ textAlign: "center", mt: 4 }}>
        <Typography variant="body2" color="text.secondary">
          <Link
            component="button"
            variant="body2"
            onClick={e => {
              e.preventDefault();
              navigate("/login");
            }}
            sx={{ textDecoration: "none" }}
          >
            Back to login
          </Link>
        </Typography>
      </Box>
    </AuthLayout>
  );
}
